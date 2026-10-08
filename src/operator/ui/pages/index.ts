import type { Item, PageId, View } from '../model.js';
import { homeItems } from './home.js';
import { assistantItems } from './assistant.js';
import { aibiItems } from './aibi.js';
import { abilitiesItems } from './abilities.js';
import { appsItems } from './apps.js';
import { systemItems } from './system.js';
import { memoryItems } from './memory.js';
import { voiceItems } from './voice.js';

const builders: Record<PageId, (view: View) => Item[]> = {
    home: homeItems,
    assistant: assistantItems,
    aibi: aibiItems,
    abilities: abilitiesItems,
    voice: voiceItems,
    memory: memoryItems,
    apps: appsItems,
    system: systemItems,
};

export const pageItems = (page: PageId, view: View): Item[] => builders[page](view);
