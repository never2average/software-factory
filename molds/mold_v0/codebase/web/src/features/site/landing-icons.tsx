import {
  IconAlertTriangle, IconBolt, IconBuilding, IconChartBar, IconCheck, IconClock, IconCode, IconEyeOff, IconFileSearch, IconFileText, IconGitCompare,
  IconListCheck, IconLock, IconMessageChatbot, IconPlug, IconRefresh, IconRobot, IconSearch, IconShieldCheck, IconTerminal2, IconUsers,
  type Icon
} from '@tabler/icons-react';
import type { IconName } from './landing-types';

/** The icons a landing block may name (src/landing.ts ICONS): the shell's own drawings, never a pack's. */
export const LANDING_ICONS: Record<IconName, Icon> = {
  'eye-off': IconEyeOff, 'git-compare': IconGitCompare, code: IconCode, search: IconSearch, 'message-chatbot': IconMessageChatbot,
  terminal: IconTerminal2, bolt: IconBolt, 'shield-check': IconShieldCheck, 'chart-bar': IconChartBar, plug: IconPlug, users: IconUsers,
  lock: IconLock, 'file-text': IconFileText, clock: IconClock, check: IconCheck, 'alert-triangle': IconAlertTriangle, 'list-check': IconListCheck,
  building: IconBuilding, robot: IconRobot, refresh: IconRefresh, 'file-search': IconFileSearch
};
