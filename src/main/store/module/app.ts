interface StoreSchema {
  bounds: object
  devToolsOpen: boolean
}

export default async function createAppStore() {
  const { default: Store } = await import('electron-store')
  return new Store<StoreSchema>({
    name: 'app',
    schema: {
      devToolsOpen: {
        default: false,
        type: 'boolean',
      },
      bounds: {
        default: {},
        type: 'object',
      },
    },
  })
}
