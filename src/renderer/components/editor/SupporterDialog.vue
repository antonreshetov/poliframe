<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useSupporter } from '@/composables/useSupporter'

const { status, open, load, activate } = useSupporter()
const key = ref('')
const activating = ref(false)
const error = ref('')
const stopListening = window.poliframe.supporter.onShowLicense(() => {
  void load()
    .then(() => {
      open.value = true
    })
    .catch(e => toast.error(String(e)))
})
onUnmounted(stopListening)
onMounted(() => {
  void load().catch(e => toast.error(String(e)))
})

async function submit() {
  if (activating.value || !key.value.trim())
    return
  activating.value = true
  error.value = ''
  try {
    await activate(key.value)
    key.value = ''
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    activating.value = false
  }
}
function visit(destination: 'gumroad' | 'paypal' | 'request') {
  void window.poliframe.supporter
    .open(destination)
    .catch(e => toast.error(String(e)))
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {{
            status?.active ? "Thank you for your support" : "Support Poliframe"
          }}
        </DialogTitle>
        <DialogDescription>
          {{
            status?.active
              ? "Your supporter key is active. Donation reminders are turned off."
              : "Hi, I’m Anton, the creator of Poliframe. I build and maintain the app on my own. Your support helps keep development going."
          }}
        </DialogDescription>
      </DialogHeader>
      <div
        v-if="status?.active"
        class="grid gap-1 text-sm text-muted-foreground break-words"
      >
        <p v-if="status.name">
          {{ status.name }}
        </p>
        <p>{{ status.email }}</p>
      </div>
      <template v-else>
        <div class="flex gap-4">
          <Button
            variant="link"
            class="px-0"
            @click="visit('gumroad')"
          >
            Gumroad
          </Button>
          <Button
            variant="link"
            class="px-0"
            @click="visit('paypal')"
          >
            PayPal
          </Button>
        </div>
        <form
          class="grid gap-3 border-t pt-4"
          @submit.prevent="submit"
        >
          <label
            for="supporter-key"
            class="text-sm font-medium"
          >Already supported Poliframe?</label>
          <p class="text-sm text-muted-foreground">
            Send your payment confirmation to request a key. Activation works
            offline and removes donation reminders.
          </p>
          <Button
            type="button"
            variant="link"
            class="justify-self-start px-0"
            @click="visit('request')"
          >
            Request a key
          </Button>
          <Input
            id="supporter-key"
            v-model="key"
            placeholder="Paste your supporter key"
            autocomplete="off"
            :aria-invalid="!!error"
            :aria-describedby="error ? 'supporter-error' : undefined"
          />
          <p
            v-if="error"
            id="supporter-error"
            role="alert"
            class="text-sm text-destructive"
          >
            {{ error }}
          </p>
          <Button
            type="submit"
            :disabled="activating || !key.trim()"
          >
            {{ activating ? "Activating…" : "Activate" }}
          </Button>
        </form>
      </template>
    </DialogContent>
  </Dialog>
</template>
