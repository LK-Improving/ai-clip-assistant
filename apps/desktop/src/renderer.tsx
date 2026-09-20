import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

const container = document.getElementById('root');
if (!container) throw new Error('渲染入口缺失：#root 节点未找到');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
