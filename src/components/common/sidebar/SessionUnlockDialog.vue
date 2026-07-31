<script setup lang="ts">
/**
 * 侧边栏会话解锁对话框
 * 输入密码解锁（缓存 token）；提供低调的「彻底移除密码锁」次级操作（复用同一密码输入）。
 * 修改密码入口保留在会话页「更多操作」菜单的密码锁对话框中。
 */

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { cacheUnlockToken, removeSessionLock, SessionLockError, verifySessionLock } from '@/services/session-lock'

const props = defineProps<{
  modelValue: boolean
  sessionId: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const { t } = useI18n()
const toast = useToast()

const isOpen = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const password = ref('')
const errorMessage = ref('')
const submitting = ref(false)

watch(isOpen, (open) => {
  if (open) {
    password.value = ''
    errorMessage.value = ''
  }
})

function translateError(err: unknown): string {
  if (err instanceof SessionLockError && err.status === 401) return t('sessionLock.errorWrong')
  return t('sessionLock.errorNetwork')
}

async function handleUnlock() {
  if (!password.value) {
    errorMessage.value = t('sessionLock.errorEmpty')
    return
  }
  submitting.value = true
  errorMessage.value = ''
  try {
    const result = await verifySessionLock(props.sessionId, password.value)
    cacheUnlockToken(props.sessionId, result.token, result.expiresAt)
    toast.success(t('sessionLock.unlockSuccess'))
    isOpen.value = false
  } catch (err) {
    errorMessage.value = translateError(err)
  } finally {
    submitting.value = false
  }
}

// 彻底移除密码锁：复用同一密码输入，验证密码归属后调用 DELETE
async function handleRemovePermanent() {
  if (!password.value) {
    errorMessage.value = t('sessionLock.errorEmpty')
    return
  }
  submitting.value = true
  errorMessage.value = ''
  try {
    await removeSessionLock(props.sessionId, password.value)
    toast.success(t('sessionLock.removeSuccess'))
    isOpen.value = false
  } catch (err) {
    errorMessage.value = translateError(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal v-model:open="isOpen" :title="t('sessionLock.title')">
    <template #body>
      <form class="space-y-4" @submit.prevent="handleUnlock">
        <p class="text-sm text-gray-600 dark:text-gray-400">{{ t('sessionLock.description') }}</p>
        <UFormField :label="t('sessionLock.passwordLabel')">
          <UInput
            v-model="password"
            type="password"
            :placeholder="t('sessionLock.passwordPlaceholder')"
            autocomplete="off"
            class="w-full"
          />
        </UFormField>
        <p v-if="errorMessage" class="text-sm text-red-500">{{ errorMessage }}</p>
      </form>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <!-- 次级操作：彻底移除密码锁（低调样式，避免误点） -->
        <UButton variant="link" color="neutral" size="xs" :loading="submitting" @click="handleRemovePermanent">
          {{ t('sessionLock.removePermanent') }}
        </UButton>
        <div class="flex gap-2">
          <UButton color="neutral" variant="ghost" @click="isOpen = false">
            {{ t('common.cancel') }}
          </UButton>
          <UButton color="primary" :loading="submitting" @click="handleUnlock">
            {{ t('sessionLock.submit') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
