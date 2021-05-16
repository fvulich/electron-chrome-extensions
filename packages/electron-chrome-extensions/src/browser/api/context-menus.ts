import { Menu, MenuItem } from 'electron'
import { MenuItemConstructorOptions } from 'electron/main'
import { ExtensionEvent } from '../router'
import { ExtensionStore } from '../store'
import { ContextMenuType, getIconImage, matchesPattern } from './common'

type ContextItemProps = chrome.contextMenus.CreateProperties & { id: string }

type ContextItemConstructorOptions = {
  extension: Electron.Extension
  props: ContextItemProps
  webContents: Electron.WebContents
  params?: Electron.ContextMenuParams
  showIcon?: boolean
}

const DEFAULT_CONTEXTS = ['page']

const getContextTypesFromParams = (params: Electron.ContextMenuParams): Set<ContextMenuType> => {
  const contexts = new Set<ContextMenuType>(['all'])

  switch (params.mediaType) {
    case 'audio':
    case 'video':
    case 'image':
      contexts.add(params.mediaType)
  }

  if (params.pageURL) contexts.add('page')
  if (params.linkURL) contexts.add('link')
  if (params.frameURL) contexts.add('frame')
  if (params.selectionText) contexts.add('selection')
  if (params.isEditable) contexts.add('editable')

  return contexts
}

const formatTitle = (title: string, params: Electron.ContextMenuParams) => {
  if (params.selectionText && title.includes('%s')) {
    title = title.split('%s').join(params.selectionText)
  }
  return title
}

const matchesConditions = (
  props: ContextItemProps,
  conditions: {
    contextTypes: Set<ContextMenuType>
    targetUrl?: string
    documentUrl?: string
  }
) => {
  if (props.enabled === false) return false

  const { contextTypes, targetUrl, documentUrl } = conditions

  const contexts = props.contexts || DEFAULT_CONTEXTS
  const inContext = contexts.some((context) => contextTypes.has(context as ContextMenuType))
  if (!inContext) return false

  if (props.targetUrlPatterns && props.targetUrlPatterns.length > 0 && targetUrl) {
    if (!props.targetUrlPatterns.some((pattern) => matchesPattern(pattern, targetUrl))) {
      return false
    }
  }

  if (props.documentUrlPatterns && props.documentUrlPatterns.length > 0 && documentUrl) {
    if (!props.documentUrlPatterns.some((pattern) => matchesPattern(pattern, documentUrl))) {
      return false
    }
  }

  return true
}

export class ContextMenusAPI {
  private menus = new Map<
    /* extensionId */ string,
    Map</* menuItemId */ string, ContextItemProps>
  >()

  constructor(private store: ExtensionStore) {
    store.handle('contextMenus.create', this.create)
    store.handle('contextMenus.remove', this.remove)
    store.handle('contextMenus.removeAll', this.removeAll)

    // TODO: remove 'any' when project is upgraded to Electron 12
    this.store.session.on('extension-unloaded' as any, (event, extension: any) => {
      if (this.menus.has(extension.id)) {
        this.menus.delete(extension.id)
      }
    })

    this.store.buildMenuItems = this.buildMenuItemsForExtension.bind(this)
  }

  private addContextItem(extensionId: string, props: ContextItemProps) {
    let contextItems = this.menus.get(extensionId)
    if (!contextItems) {
      contextItems = new Map()
      this.menus.set(extensionId, contextItems)
    }
    contextItems.set(props.id, props)
  }

  private buildMenuItem = (opts: ContextItemConstructorOptions) => {
    const { extension, props, webContents, params } = opts

    // TODO: try to get the appropriately sized image before resizing
    let icon = opts.showIcon ? getIconImage(extension) : undefined
    if (icon) {
      icon = icon.resize({ width: 16, height: 16 })
    }

    const menuItemOptions: MenuItemConstructorOptions = {
      id: props.id,
      type: props.type as any,
      label: params ? formatTitle(props.title || '', params) : props.title || '',
      icon,
      click: () => {
        this.onClicked(extension.id, props.id, webContents, params)
      },
    }

    return menuItemOptions
  }

  private buildMenuItemsFromTemplate = (menuItemTemplates: ContextItemConstructorOptions[]) => {
    const itemMap = new Map<string, MenuItemConstructorOptions>()

    // Group by ID
    for (const item of menuItemTemplates) {
      const menuItem = this.buildMenuItem(item)
      itemMap.set(item.props.id, menuItem)
    }

    // Organize in tree
    for (const item of menuItemTemplates) {
      const menuItem = itemMap.get(item.props.id)
      if (item.props.parentId) {
        const parentMenuItem = itemMap.get(item.props.parentId)
        if (parentMenuItem) {
          const submenu = (parentMenuItem.submenu || []) as Electron.MenuItemConstructorOptions[]
          submenu.push(menuItem!)
          parentMenuItem.submenu = submenu
        }
      }
    }

    const menuItems: Electron.MenuItem[] = []

    const buildFromTemplate = (opts: Electron.MenuItemConstructorOptions) => {
      if (Array.isArray(opts.submenu)) {
        const submenu = new Menu()
        opts.submenu.forEach((item) => submenu.append(buildFromTemplate(item)))
        opts.submenu = submenu
      }
      return new MenuItem(opts)
    }

    // Build all final MenuItems in-order
    for (const item of menuItemTemplates) {
      // Items with parents will be handled recursively
      if (item.props.parentId) continue

      const menuItem = itemMap.get(item.props.id)!
      menuItems.push(buildFromTemplate(menuItem))
    }

    return menuItems
  }

  buildMenuItemsForParams(
    webContents: Electron.WebContents,
    params: Electron.ContextMenuParams
  ): Electron.MenuItem[] {
    if (webContents.session !== this.store.session) return []

    const menuItemOptions = []

    const conditions = {
      contextTypes: getContextTypesFromParams(params),
      targetUrl: params.srcURL || params.linkURL,
      documentUrl: params.frameURL || params.pageURL,
    }

    for (const [extensionId, propItems] of this.menus) {
      const extension = this.store.session.getExtension(extensionId)
      if (!extension) continue

      for (const [, props] of propItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = {
            extension,
            props,
            webContents,
            params,
            showIcon: true,
          }
          menuItemOptions.push(menuItem)
        }
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private buildMenuItemsForExtension(
    extensionId: string,
    menuType: ContextMenuType
  ): Electron.MenuItem[] {
    const extensionItems = this.menus.get(extensionId)
    const extension = this.store.session.getExtension(extensionId)
    const activeTab = this.store.getActiveTabOfCurrentWindow()

    const menuItemOptions = []

    if (extensionItems && extension && activeTab) {
      const conditions = {
        contextTypes: new Set<ContextMenuType>(['all', menuType]),
      }

      for (const [, props] of extensionItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = { extension, props, webContents: activeTab }
          menuItemOptions.push(menuItem)
        }
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private create = ({ extension }: ExtensionEvent, createProperties: ContextItemProps) => {
    const { id, type, title } = createProperties

    if (this.menus.has(id)) {
      // TODO: duplicate error
      return
    }

    if (!title && type !== 'separator') {
      // TODO: error
      return
    }

    this.addContextItem(extension.id, createProperties)
  }

  private remove = ({ extension }: ExtensionEvent, menuItemId: string) => {
    const items = this.menus.get(extension.id)
    if (items && items.has(menuItemId)) {
      items.delete(menuItemId)
      if (items.size === 0) {
        this.menus.delete(extension.id)
      }
    }
  }

  private removeAll = ({ extension }: ExtensionEvent) => {
    this.menus.delete(extension.id)
  }

  private onClicked(
    extensionId: string,
    menuItemId: string,
    webContents: Electron.WebContents,
    params?: Electron.ContextMenuParams
  ) {
    if (webContents.isDestroyed()) return

    const tab = this.store.tabDetailsCache.get(webContents.id)
    if (!tab) {
      console.error(`[Extensions] Unable to find tab for id=${webContents.id}`)
      return
    }

    const data: chrome.contextMenus.OnClickData = {
      selectionText: params?.selectionText,
      checked: false, // TODO
      menuItemId,
      frameId: -1, // TODO: match frameURL with webFrameMain in Electron 12
      frameUrl: params?.frameURL,
      editable: params?.isEditable || false,
      mediaType: params?.mediaType,
      wasChecked: false, // TODO
      pageUrl: params?.pageURL as any, // types are inaccurate
      linkUrl: params?.linkURL,
      parentMenuItemId: -1, // TODO
      srcUrl: params?.srcURL,
    }

    this.store.sendToExtensionHost(extensionId, 'contextMenus.onClicked', data, tab)
  }
}
