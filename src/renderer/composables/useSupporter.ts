import type { SupporterStatus } from '../../shared/contracts'
import { ref } from 'vue'
import { toast } from 'vue-sonner'

const status = ref<SupporterStatus | null>(null)
const open = ref(false)
const toastId = 'support-poliframe'

export function useSupporter() {
  function prompt() {
    if (status.value?.active)
      return
    toast('Enjoying Poliframe?', {
      id: toastId,
      description:
        'Hi, I’m Anton, the creator of Poliframe. I build and maintain the app on my own. Your support helps keep development going.',
      duration: Infinity,
      action: {
        label: 'Support',
        onClick: () => {
          open.value = true
        },
      },
      cancel: { label: 'Not now', onClick: () => {} },
    })
  }

  async function load() {
    status.value = await window.poliframe.supporter.status()
  }

  async function activate(key: string) {
    status.value = await window.poliframe.supporter.activate(key)
    toast.dismiss(toastId)
  }

  return { status, open, prompt, load, activate }
}
