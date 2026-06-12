import { useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Link, useNavigate } from 'react-router-dom'
import { loginThunk, selectAuth } from '../features/auth/authSlice'

function LoginPage() {
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const { isLoading, error } = useSelector(selectAuth)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  async function onSubmit(event) {
    event.preventDefault()
    const result = await dispatch(loginThunk({ email, password }))
    if (loginThunk.fulfilled.match(result)) {
      navigate('/dashboard')
    }
  }

  return (
    <main className="auth-page">
      <h1>Sign in</h1>
      <form className="auth-form" onSubmit={onSubmit}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={8}
          maxLength={128}
          required
        />
        <button type="submit" disabled={isLoading}>
          {isLoading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      {error ? <p className="error-text">{String(error)}</p> : null}
      <p>
        No account? <Link to="/register">Create one</Link>
      </p>
    </main>
  )
}

export default LoginPage
