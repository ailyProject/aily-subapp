import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '../public/fonts/fontawesome6/css/aily-chat-icons.css';
import './styles.scss';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
