import type { AppApi } from '../../shared/contracts'

declare global {
  interface Window {
    poliframe: AppApi
  }
}
export {}
