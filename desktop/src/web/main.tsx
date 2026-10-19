import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/lib/theme";
import "@/index.css";
import { ClientApp } from "@/client/App";
import { BackendContext } from "@/client/backend";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { boot, web } from "./store";

boot();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <BackendContext.Provider value={web}>
        <ClientApp />
      </BackendContext.Provider>
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  </StrictMode>,
);
