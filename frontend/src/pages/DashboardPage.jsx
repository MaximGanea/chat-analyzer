import { useDispatch, useSelector } from 'react-redux'
import { Link } from 'react-router-dom'
import { logoutThunk, selectAuth } from '../features/auth/authSlice'

function DashboardPage() {
  const dispatch = useDispatch()
  const { user } = useSelector(selectAuth)

  return (
    <main className="auth-page">
      <h1>Dashboard</h1>
      <p>Signed in as: {user?.email}</p>
      <p>Role: {user?.role}</p>
      <nav className="dashboard-nav">
        <Link to="/admin">Admin</Link>
      </nav>
      <button type="button" onClick={() => dispatch(logoutThunk())}>
        Logout
      </button>
    </main>
  )
}

export default DashboardPage
