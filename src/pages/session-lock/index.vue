<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ThemeCard } from '@/components/UI'
import {
  cacheUnlockToken,
  getCachedUnlockToken,
  getSessionLockStatus,
  SessionLockError,
  verifySessionLock,
} from '@/services/session-lock'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

const sessionId = route.params.id as string

const passwordInput = ref('')
const error = ref('')
const loading = ref(false)

function sanitizeRedirect(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('/session-lock') || raw.startsWith('/login')) return '/'
  return raw
}

function redirectTarget(): string {
  return sanitizeRedirect(route.query.redirect as string)
}

async function handleUnlock() {
  const password = passwordInput.value
  if (!password) {
    error.value = t('sessionLock.errorEmpty')
    return
  }

  loading.value = true
  error.value = ''

  try {
    const result = await verifySessionLock(sessionId, password)
    cacheUnlockToken(sessionId, result.token, result.expiresAt)
    router.replace(redirectTarget())
  } catch (err) {
    error.value =
      err instanceof SessionLockError && err.status === 401
        ? t('sessionLock.errorWrong')
        : t('sessionLock.errorNetwork')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  // 已有有效 token 或会话未锁定时直接放行，避免停留在解锁页
  if (getCachedUnlockToken(sessionId)) {
    router.replace(redirectTarget())
    return
  }
  try {
    const status = await getSessionLockStatus(sessionId)
    if (!status.locked) router.replace(redirectTarget())
  } catch {
    // 查询失败（无此后端、网络错误等）停留在解锁页，由用户决定是否输入密码
  }
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-page-dark">
    <ThemeCard class="w-full max-w-sm space-y-6 p-8">
      <div class="text-center">
        <UIcon name="i-heroicons-lock-closed" class="mx-auto h-10 w-10 text-primary-500" />
        <h1 class="mt-3 text-2xl font-bold text-gray-900 dark:text-white">{{ t('sessionLock.title') }}</h1>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {{ t('sessionLock.description') }}
        </p>
      </div>

      <form class="space-y-4" @submit.prevent="handleUnlock">
        <UFormField :label="t('sessionLock.passwordLabel')">
          <UInput
            v-model="passwordInput"
            type="password"
            :placeholder="t('sessionLock.passwordPlaceholder')"
            autocomplete="off"
            class="w-full"
          />
        </UFormField>

        <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

        <UButton type="submit" block :loading="loading" color="primary">
          {{ t('sessionLock.submit') }}
        </UButton>
      </form>

      <p class="text-center">
        <UButton variant="link" color="neutral" size="sm" @click="router.replace('/')">
          {{ t('sessionLock.backHome') }}
        </UButton>
      </p>
    </ThemeCard>
  </div>
</template>
