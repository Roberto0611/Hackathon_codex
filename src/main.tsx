import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App'
import SimuladorTerreno from './SimuladorTerreno'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/simulador" element={<SimuladorTerreno />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
