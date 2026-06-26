import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import authReducer from '../authSlice'
import AdminRoute from './AdminRoute'

function renderWithState(authState) {
  const store = configureStore({
    reducer: { auth: authReducer },
    preloadedState: { auth: { user: null, isAuthenticated: false, isLoading: false, isBootstrapping: false, error: null, ...authState } },
  })

  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<AdminRoute><div>admin content</div></AdminRoute>} />
          <Route path="/dashboard" element={<div>dashboard page</div>} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    </Provider>
  )
}

describe('AdminRoute', () => {
  it('renders children when authenticated as admin', () => {
    renderWithState({ isAuthenticated: true, isBootstrapping: false, user: { id: 1, role: 'admin' } })
    expect(screen.getByText('admin content')).toBeInTheDocument()
  })

  it('redirects to /dashboard when authenticated but not admin', () => {
    renderWithState({ isAuthenticated: true, isBootstrapping: false, user: { id: 2, role: 'user' } })
    expect(screen.getByText('dashboard page')).toBeInTheDocument()
    expect(screen.queryByText('admin content')).not.toBeInTheDocument()
  })

  it('redirects to /login when not authenticated', () => {
    renderWithState({ isAuthenticated: false, isBootstrapping: false, user: null })
    expect(screen.getByText('login page')).toBeInTheDocument()
    expect(screen.queryByText('admin content')).not.toBeInTheDocument()
  })

  it('shows loading state while bootstrapping — no redirect yet', () => {
    renderWithState({ isAuthenticated: false, isBootstrapping: true, user: null })
    expect(screen.getByText('Checking session...')).toBeInTheDocument()
    expect(screen.queryByText('login page')).not.toBeInTheDocument()
  })
})
