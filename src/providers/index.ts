import { mockProvider } from '../chat'
import { createRealProvider } from './real'
export const isRealMode = import.meta.env.MODE === 'real'
export const modelProvider = isRealMode ? createRealProvider() : mockProvider
