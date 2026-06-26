import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import authReducer from '../authSlice'
import ProtectedRoute from './ProtectedRoute'

function renderWithState(authState) {
  const store = configureStore({
    reducer: { auth: authReducer },
    preloadedState: { auth: { user: null, isAuthenticated: false, isLoading: false, isBootstrapping: false, error: null, ...authState } },
  })

  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<ProtectedRoute><div>protected content</div></ProtectedRoute>} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    </Provider>
  )
}

describe('ProtectedRoute', () => {
  it('renders children when authenticated and not bootstrapping', () => {
    renderWithState({ isAuthenticated: true, isBootstrapping: false })
    expect(screen.getByText('protected content')).toBeInTheDocument()
  })

  it('redirects to /login when not authenticated', () => {
    renderWithState({ isAuthenticated: false, isBootstrapping: false })
    expect(screen.getByText('login page')).toBeInTheDocument()
    expect(screen.queryByText('protected content')).not.toBeInTheDocument()
  })

  it('shows loading state while bootstrapping — no redirect yet', () => {
    renderWithState({ isAuthenticated: false, isBootstrapping: true })
    expect(screen.getByText('Checking session...')).toBeInTheDocument()
    expect(screen.queryByText('login page')).not.toBeInTheDocument()
    expect(screen.queryByText('protected content')).not.toBeInTheDocument()
  })
})
