<script setup lang="ts">
/**
 * 会话密码锁管理对话框
 * 未锁定时设置密码；已锁定时支持修改密码和移除密码锁。
 */

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import {
  cacheUnlockToken,
  clearUnlockToken,
  getSessionLockStatus,
  removeSessionLock,
  SessionLockError,
  setSessionLock,
  verifySessionLock,
} from '@/services/session-lock'

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

type Stage = 'loading' | 'set' | 'manage' | 'error'
const stage = ref<Stage>('loading')
// 已锁定时子模式：修改密码 / 移除密码锁
const manageMode = ref<'change' | 'remove'>('change')

const oldPassword = ref('')
const password = ref('')
const confirmPassword = ref('')
const errorMessage = ref('')
const submitting = ref(false)

watch(isOpen, (open) => {
  if (open) loadStatus()
})

function resetForm() {
  oldPassword.value = ''
  password.value = ''
  confirmPassword.value = ''
  errorMessage.value = ''
}

async function loadStatus() {
  stage.value = 'loading'
  resetForm()
  try {
    const status = await getSessionLockStatus(props.sessionId)
    stage.value = status.locked ? 'manage' : 'set'
  } catch {
    stage.value = 'error'
  }
}

/** 设置/修改成功后立即换取解锁 token，避免当前页面后续请求被 423 拦截。 */
async function refreshUnlockToken(newPassword: string) {
  const result = await verifySessionLock(props.sessionId, newPassword)
  cacheUnlockToken(props.sessionId, result.token, result.expiresAt)
}

function validateNewPassword(): boolean {
  if (password.value.length < 4) {
    errorMessage.value = t('sessionLock.errorTooShort')
    return false
  }
  if (password.value !== confirmPassword.value) {
    errorMessage.value = t('sessionLock.errorMismatch')
    return false
  }
  return true
}

function translateSubmitError(err: unknown, wrongPasswordKey: string): string {
  if (err instanceof SessionLockError) {
    if (err.status === 401) return t(wrongPasswordKey)
    if (err.status === 400) return t('sessionLock.errorTooShort')
  }
  return t('sessionLock.errorNetwork')
}

async function handleSet() {
  if (!validateNewPassword()) return
  submitting.value = true
  errorMessage.value = ''
  try {
    await setSessionLock(props.sessionId, password.value)
    await refreshUnlockToken(password.value)
    toast.success(t('sessionLock.setSuccess'))
    isOpen.value = false
  } catch (err) {
    errorMessage.value = translateSubmitError(err, 'sessionLock.errorWrong')
  } finally {
    submitting.value = false
  }
}

async function handleChange() {
  if (!oldPassword.value) {
    errorMessage.value = t('sessionLock.errorEmpty')
    return
  }
  if (!validateNewPassword()) return
  submitting.value = true
  errorMessage.value = ''
  try {
    await setSessionLock(props.sessionId, password.value, oldPassword.value)
    await refreshUnlockToken(password.value)
    toast.success(t('sessionLock.changeSuccess'))
    isOpen.value = false
  } catch (err) {
    errorMessage.value = translateSubmitError(err, 'sessionLock.errorOldWrong')
  } finally {
    submitting.value = false
  }
}

async function handleRemove() {
  if (!oldPassword.value) {
    errorMessage.value = t('sessionLock.errorEmpty')
    return
  }
  submitting.value = true
  errorMessage.value = ''
  try {
    await removeSessionLock(props.sessionId, oldPassword.value)
    clearUnlockToken(props.sessionId)
    toast.success(t('sessionLock.removeSuccess'))
    isOpen.value = false
  } catch (err) {
    errorMessage.value = translateSubmitError(err, 'sessionLock.errorWrong')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal v-model:open="isOpen" :title="t('sessionLock.dialogTitle')">
    <template #body>
      <div class="min-h-[160px]">
        <!-- 加载中 -->
        <div v-if="stage === 'loading'" class="flex items-center justify-center py-10">
          <UIcon name="i-heroicons-arrow-path" class="h-6 w-6 animate-spin text-gray-400" />
        </div>

        <!-- 状态查询失败（如无密码锁后端） -->
        <div v-else-if="stage === 'error'" class="flex flex-col items-center justify-center py-10">
          <UIcon name="i-heroicons-exclamation-triangle" class="mb-3 h-8 w-8 text-amber-500" />
          <p class="text-sm text-gray-600 dark:text-gray-400">{{ t('sessionLock.loadError') }}</p>
        </div>

        <!-- 未锁定：设置密码 -->
        <form v-else-if="stage === 'set'" class="space-y-4" @submit.prevent="handleSet">
          <p class="text-sm text-gray-600 dark:text-gray-400">{{ t('sessionLock.setDescription') }}</p>
          <UFormField :label="t('sessionLock.newPasswordLabel')">
            <UInput
              v-model="password"
              type="password"
              :placeholder="t('sessionLock.passwordPlaceholder')"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('sessionLock.confirmLabel')">
            <UInput
              v-model="confirmPassword"
              type="password"
              :placeholder="t('sessionLock.confirmPlaceholder')"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>
          <p v-if="errorMessage" class="text-sm text-red-500">{{ errorMessage }}</p>
        </form>

        <!-- 已锁定：修改 / 移除 -->
        <div v-else class="space-y-4">
          <div class="flex gap-2">
            <UButton
              size="sm"
              :color="manageMode === 'change' ? 'primary' : 'neutral'"
              :variant="manageMode === 'change' ? 'soft' : 'ghost'"
              @click="((manageMode = 'change'), (errorMessage = ''))"
            >
              {{ t('sessionLock.changeTab') }}
            </UButton>
            <UButton
              size="sm"
              :color="manageMode === 'remove' ? 'primary' : 'neutral'"
              :variant="manageMode === 'remove' ? 'soft' : 'ghost'"
              @click="((manageMode = 'remove'), (errorMessage = ''))"
            >
              {{ t('sessionLock.removeTab') }}
            </UButton>
          </div>

          <form v-if="manageMode === 'change'" class="space-y-4" @submit.prevent="handleChange">
            <UFormField :label="t('sessionLock.oldPasswordLabel')">
              <UInput
                v-model="oldPassword"
                type="password"
                :placeholder="t('sessionLock.passwordPlaceholder')"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('sessionLock.newPasswordLabel')">
              <UInput
                v-model="password"
                type="password"
                :placeholder="t('sessionLock.passwordPlaceholder')"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('sessionLock.confirmLabel')">
              <UInput
                v-model="confirmPassword"
                type="password"
                :placeholder="t('sessionLock.confirmPlaceholder')"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
            <p v-if="errorMessage" class="text-sm text-red-500">{{ errorMessage }}</p>
          </form>

          <form v-else class="space-y-4" @submit.prevent="handleRemove">
            <p class="text-sm text-gray-600 dark:text-gray-400">{{ t('sessionLock.removeDescription') }}</p>
            <UFormField :label="t('sessionLock.passwordLabel')">
              <UInput
                v-model="oldPassword"
                type="password"
                :placeholder="t('sessionLock.passwordPlaceholder')"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
            <p v-if="errorMessage" class="text-sm text-red-500">{{ errorMessage }}</p>
          </form>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="isOpen = false">
          {{ t('common.cancel') }}
        </UButton>
        <template v-if="stage === 'set'">
          <UButton color="primary" :loading="submitting" @click="handleSet">
            {{ t('common.confirm') }}
          </UButton>
        </template>
        <template v-else-if="stage === 'manage' && manageMode === 'change'">
          <UButton color="primary" :loading="submitting" @click="handleChange">
            {{ t('common.confirm') }}
          </UButton>
        </template>
        <template v-else-if="stage === 'manage' && manageMode === 'remove'">
          <UButton color="error" :loading="submitting" @click="handleRemove">
            {{ t('sessionLock.removeConfirm') }}
          </UButton>
        </template>
      </div>
    </template>
  </UModal>
</template>
