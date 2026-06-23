import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import LoginForm, { authClient } from './LoginForm.jsx'

function Root() {
  const [session, setSession] = useState(undefined) // undefined = loading

  useEffect(() => {
    authClient.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
    })
    const { data: { subscription } } = authClient.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return (
      <div className="h-screen flex items-center justify-center text-gray-400 text-sm">
        loading…
      </div>
    )
  }

  if (!session) {
    return <LoginForm onLogin={setSession} />
  }

  return <App session={session} onSignOut={() => {
    authClient.auth.signOut()
    setSession(null)
  }} />
}

createRoot(document.getElementById('root')).render(
  <StrictMode><Root /></StrictMode>
)
