import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyDocumentFavicon } from './services/appFavicon'
import { applyThemeModeToDocument, getStoredThemeMode } from './constants/theme'

applyDocumentFavicon(document)
const initialThemeMode = getStoredThemeMode()
applyThemeModeToDocument(initialThemeMode)

createRoot(document.getElementById('root')!).render(
  <App initialThemeMode={initialThemeMode} />,
)
