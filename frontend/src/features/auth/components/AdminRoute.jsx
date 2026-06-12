import { Navigate } from 'react-router-dom'
import { useSelector } from 'react-redux'
import { selectAuth, selectIsAdmin } from '../authSlice'

function AdminRoute({ children }) {
  const { isAuthenticated, isBootstrapping } = useSelector(selectAuth)
  const isAdmin = useSelector(selectIsAdmin)

  if (isBootstrapping) {
    return <p>Checking session...</p>
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (!isAdmin) {
    return <Navigate to="/dashboard" replace />
  }

  return children
}

export default AdminRoute
