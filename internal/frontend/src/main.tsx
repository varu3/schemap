import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './App';
import './index.css';
import './overrides.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider>
        <ReactFlowProvider>
          <App />
        </ReactFlowProvider>
      </TooltipProvider>
    </StrictMode>,
  );
}
