import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import { api } from '../../services/api'
import { clearAccessToken, setAccessToken } from '../../services/tokenService'

const initialState = {
  user: null,
  isAuthenticated: false,
  isLoading: false,
  isBootstrapping: true,
  error: null,
}

export const registerThunk = createAsyncThunk(
  'auth/register',
  async ({ email, password }, { rejectWithValue }) => {
    try {
      const { data } = await api.post('/api/auth/register', { email, password })
      setAccessToken(data.access_token)
      return data
    } catch (error) {
      return rejectWithValue(error.response?.data?.detail ?? 'Register failed')
    }
  },
)

export const loginThunk = createAsyncThunk(
  'auth/login',
  async ({ email, password }, { rejectWithValue }) => {
    try {
      const { data } = await api.post('/api/auth/login', { email, password })
      setAccessToken(data.access_token)
      return data
    } catch (error) {
      return rejectWithValue(error.response?.data?.detail ?? 'Login failed')
    }
  },
)

export const bootstrapSessionThunk = createAsyncThunk('auth/bootstrap', async (_, { rejectWithValue }) => {
  try {
    const { data } = await api.post('/api/auth/refresh')
    setAccessToken(data.access_token)
    return data
  } catch (error) {
    clearAccessToken()
    return rejectWithValue(null)
  }
})

export const logoutThunk = createAsyncThunk('auth/logout', async (_, { rejectWithValue }) => {
  try {
    await api.post('/api/auth/logout')
    clearAccessToken()
  } catch (error) {
    return rejectWithValue(error.response?.data?.detail ?? 'Logout failed')
  }
})

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(registerThunk.pending, (state) => {
        state.isLoading = true
        state.error = null
      })
      .addCase(registerThunk.fulfilled, (state, action) => {
        state.isLoading = false
        state.isAuthenticated = true
        state.user = action.payload.user
      })
      .addCase(registerThunk.rejected, (state, action) => {
        state.isLoading = false
        state.error = action.payload
      })

      .addCase(loginThunk.pending, (state) => {
        state.isLoading = true
        state.error = null
      })
      .addCase(loginThunk.fulfilled, (state, action) => {
        state.isLoading = false
        state.isAuthenticated = true
        state.user = action.payload.user
      })
      .addCase(loginThunk.rejected, (state, action) => {
        state.isLoading = false
        state.error = action.payload
      })

      .addCase(bootstrapSessionThunk.fulfilled, (state, action) => {
        state.isBootstrapping = false
        state.isAuthenticated = true
        state.user = action.payload.user
      })
      .addCase(bootstrapSessionThunk.rejected, (state) => {
        state.isBootstrapping = false
        state.isAuthenticated = false
        state.accessToken = null
        state.user = null
      })

      .addCase(logoutThunk.fulfilled, (state) => {
        state.isAuthenticated = false
        state.user = null
        state.error = null
      })
      .addCase(logoutThunk.rejected, (state) => {
        state.isAuthenticated = false
        state.user = null
        state.error = null
      })
  },
})

export const selectAuth = (state) => state.auth
export const selectIsAdmin = (state) => state.auth.user?.role === 'admin'

export default authSlice.reducer
