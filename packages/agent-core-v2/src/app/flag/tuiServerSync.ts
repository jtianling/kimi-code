import { registerFlagDefinition } from './flagRegistry';

registerFlagDefinition({
  id: 'tui-server-sync',
  title: 'TUI server-turn sync',
  description: 'Show external server-driven turns in the attached TUI.',
  env: 'KIMI_CODE_EXPERIMENTAL_TUI_SERVER_SYNC',
  default: false,
  surface: 'tui',
});
