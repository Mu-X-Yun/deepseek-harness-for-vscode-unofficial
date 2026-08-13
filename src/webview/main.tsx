import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('webview root element missing')
createRoot(root).render(<App />)
