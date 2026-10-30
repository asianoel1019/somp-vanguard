import { createContext, useContext } from 'react';

export const AgentContext = createContext({ available: false, investigate: () => {} });

export const useAgent = () => useContext(AgentContext);
