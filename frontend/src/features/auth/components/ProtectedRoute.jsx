import { Navigate } from 'react-router-dom'
import { useSelector } from 'react-redux'
import { selectAuth } from '../authSlice'

function ProtectedRoute({ children }) {
  const { isAuthenticated, isBootstrapping } = useSelector(selectAuth)

  if (isBootstrapping) {
    return <p>Checking session...</p>
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return children
}

export default ProtectedRoute
