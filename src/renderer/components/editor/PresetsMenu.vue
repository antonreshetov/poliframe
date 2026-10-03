<script setup lang="ts">
import { Bookmark } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useEditorContext } from '@/composables/useEditor'

const e = useEditorContext()
const mode = ref<'new' | 'rename' | 'delete' | null>(null)
const name = ref('')
const active = computed(() => e.presets.find(p => p.id === e.activePreset))
async function apply() {
  if (mode.value === 'delete')
    await e.deletePreset(e.activePreset)
  else if (mode.value === 'rename')
    await e.renamePreset(e.activePreset, name.value)
  else await e.savePreset(name.value)
  mode.value = null
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="secondary"
        size="sm"
      >
        <Bookmark />{{
          active?.name
            || (e.activePreset === "builtin" ? "Passe-partout + Caption" : "Presets")
        }}
        <span
          v-if="e.presetModified"
          class="size-1.5 rounded-full bg-green-500"
          aria-label="Modified preset"
        />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      side="top"
      align="end"
    >
      <DropdownMenuLabel>Presets</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup :model-value="e.activePreset">
        <DropdownMenuRadioItem
          value="defaults"
          @select="e.applyPreset('defaults')"
        >
          Defaults
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value="builtin"
          @select="e.applyPreset('builtin')"
        >
          <span class="min-w-0 truncate">Passe-partout + Caption</span>
        </DropdownMenuRadioItem>
        <DropdownMenuSeparator v-if="e.presets.length" />
        <DropdownMenuRadioItem
          v-for="preset in e.presets"
          :key="preset.id"
          :value="preset.id"
          @select="e.applyPreset(preset.id)"
        >
          <span
            class="min-w-0 truncate"
            :title="preset.name"
          >{{
            preset.name
          }}</span>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <template v-if="active">
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="e.savePreset(active.name, active.id)">
          Update
        </DropdownMenuItem>
        <DropdownMenuItem
          @select="
            name = active.name;
            mode = 'rename';
          "
        >
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          @select="mode = 'delete'"
        >
          Delete
        </DropdownMenuItem>
      </template>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        @select="
          name = '';
          mode = 'new';
        "
      >
        Save as new…
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
  <Dialog
    :open="!!mode"
    @update:open="!$event && (mode = null)"
  >
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {{
            mode === "delete"
              ? "Delete preset?"
              : mode === "rename"
                ? "Rename preset"
                : "Save preset"
          }}
        </DialogTitle><DialogDescription>
          {{
            mode === "delete"
              ? `“${active?.name}” will be permanently removed.`
              : "Save the current framing and annotation settings."
          }}
        </DialogDescription>
      </DialogHeader><Input
        v-if="mode !== 'delete'"
        v-model="name"
        placeholder="Preset name"
        aria-label="Preset name"
        @keydown.enter="name.trim() && apply()"
      /><DialogFooter>
        <Button
          variant="outline"
          @click="mode = null"
        >
          Cancel
        </Button><Button
          :disabled="mode !== 'delete' && !name.trim()"
          :variant="mode === 'delete' ? 'destructive' : 'default'"
          @click="apply"
        >
          {{ mode === "delete" ? "Delete" : "Save" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
