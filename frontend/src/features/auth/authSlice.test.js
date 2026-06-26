import { configureStore } from '@reduxjs/toolkit'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import authReducer, {
  loginThunk,
  logoutThunk,
  bootstrapSessionThunk,
  registerThunk,
} from './authSlice'

vi.mock('../../services/api', () => ({
  api: { post: vi.fn() },
}))

vi.mock('../../services/tokenService', () => ({
  setAccessToken: vi.fn(),
  clearAccessToken: vi.fn(),
}))

import { api } from '../../services/api'

function makeStore() {
  return configureStore({ reducer: { auth: authReducer } })
}

beforeEach(() => vi.clearAllMocks())

describe('loginThunk', () => {
  it('fulfilled → isAuthenticated true, user set', async () => {
    api.post.mockResolvedValueOnce({ data: { access_token: 'tok', user: { id: 1, email: 'a@b.com', role: 'user' } } })
    const store = makeStore()
    await store.dispatch(loginThunk({ email: 'a@b.com', password: 'password1' }))
    const { isAuthenticated, user, isLoading, error } = store.getState().auth
    expect(isAuthenticated).toBe(true)
    expect(user).toEqual({ id: 1, email: 'a@b.com', role: 'user' })
    expect(isLoading).toBe(false)
    expect(error).toBeNull()
  })

  it('rejected → error set, isAuthenticated false', async () => {
    api.post.mockRejectedValueOnce({ response: { data: { detail: 'Invalid credentials' } } })
    const store = makeStore()
    await store.dispatch(loginThunk({ email: 'a@b.com', password: 'wrongpass' }))
    const { isAuthenticated, error, isLoading } = store.getState().auth
    expect(isAuthenticated).toBe(false)
    expect(error).toBe('Invalid credentials')
    expect(isLoading).toBe(false)
  })

  it('pending → isLoading true, error cleared', () => {
    api.post.mockReturnValueOnce(new Promise(() => {}))
    const store = makeStore()
    store.dispatch(loginThunk({ email: 'a@b.com', password: 'password1' }))
    const { isLoading, error } = store.getState().auth
    expect(isLoading).toBe(true)
    expect(error).toBeNull()
  })
})

describe('logoutThunk', () => {
  const authedState = { user: { id: 1 }, isAuthenticated: true, isLoading: false, isBootstrapping: false, error: null }

  it('fulfilled → state cleared', async () => {
    api.post.mockResolvedValueOnce({})
    const store = configureStore({ reducer: { auth: authReducer }, preloadedState: { auth: authedState } })
    await store.dispatch(logoutThunk())
    const { isAuthenticated, user } = store.getState().auth
    expect(isAuthenticated).toBe(false)
    expect(user).toBeNull()
  })

  it('rejected → state still cleared (API failure must not block logout)', async () => {
    api.post.mockRejectedValueOnce(new Error('network'))
    const store = configureStore({ reducer: { auth: authReducer }, preloadedState: { auth: authedState } })
    await store.dispatch(logoutThunk())
    const { isAuthenticated, user } = store.getState().auth
    expect(isAuthenticated).toBe(false)
    expect(user).toBeNull()
  })
})

describe('bootstrapSessionThunk', () => {
  it('fulfilled → isBootstrapping false, user set', async () => {
    api.post.mockResolvedValueOnce({ data: { access_token: 'tok', user: { id: 2, role: 'admin' } } })
    const store = makeStore()
    await store.dispatch(bootstrapSessionThunk())
    const { isBootstrapping, isAuthenticated, user } = store.getState().auth
    expect(isBootstrapping).toBe(false)
    expect(isAuthenticated).toBe(true)
    expect(user).toEqual({ id: 2, role: 'admin' })
  })

  it('rejected → isBootstrapping false, isAuthenticated false', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 401 } })
    const store = makeStore()
    await store.dispatch(bootstrapSessionThunk())
    const { isBootstrapping, isAuthenticated, user } = store.getState().auth
    expect(isBootstrapping).toBe(false)
    expect(isAuthenticated).toBe(false)
    expect(user).toBeNull()
  })
})

describe('registerThunk', () => {
  it('fulfilled → isAuthenticated true, user set', async () => {
    api.post.mockResolvedValueOnce({ data: { access_token: 'tok', user: { id: 3, email: 'new@b.com', role: 'user' } } })
    const store = makeStore()
    await store.dispatch(registerThunk({ email: 'new@b.com', password: 'password1' }))
    const { isAuthenticated, user } = store.getState().auth
    expect(isAuthenticated).toBe(true)
    expect(user.email).toBe('new@b.com')
  })

  it('rejected → error set', async () => {
    api.post.mockRejectedValueOnce({ response: { data: { detail: 'Email already exists' } } })
    const store = makeStore()
    await store.dispatch(registerThunk({ email: 'dup@b.com', password: 'password1' }))
    expect(store.getState().auth.error).toBe('Email already exists')
  })
})
