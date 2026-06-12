import { useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Link, useNavigate } from 'react-router-dom'
import { registerThunk, selectAuth } from '../features/auth/authSlice'

function RegisterPage() {
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const { isLoading, error } = useSelector(selectAuth)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  async function onSubmit(event) {
    event.preventDefault()
    const result = await dispatch(registerThunk({ email, password }))
    if (registerThunk.fulfilled.match(result)) {
      navigate('/dashboard')
    }
  }

  return (
    <main className="auth-page">
      <h1>Create account</h1>
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
          {isLoading ? 'Creating...' : 'Create account'}
        </button>
      </form>
      {error ? <p className="error-text">{String(error)}</p> : null}
      <p>
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </main>
  )
}

export default RegisterPage
