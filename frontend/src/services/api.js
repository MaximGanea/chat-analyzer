import axios from 'axios'
import { clearAccessToken, getAccessToken, setAccessToken } from './tokenService'

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
})

let refreshPromise = null

api.interceptors.request.use((config) => {
  const token = getAccessToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config

    if (
      error.response?.status === 401 &&
      !originalRequest?._retry &&
      !originalRequest?.url?.includes('/api/auth/refresh')
    ) {
      originalRequest._retry = true

      try {
        refreshPromise ??= api.post('/api/auth/refresh')
        const { data } = await refreshPromise
        setAccessToken(data.access_token)
        originalRequest.headers.Authorization = `Bearer ${data.access_token}`
        return api(originalRequest)
      } catch (refreshError) {
        clearAccessToken()
        return Promise.reject(refreshError)
      } finally {
        refreshPromise = null
      }
    }

    return Promise.reject(error)
  },
)
