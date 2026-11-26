import { addEnglish } from "../../../../shared/i18n.ts";
import { conversationEn } from "./conversation.ts";
import { settingsEn } from "./settings.ts";
import { pluginsEn } from "./plugins.ts";
import { cardsEn } from "./cards.ts";

// 各区域一个文件，分票翻译时互不冲突；导入这个文件就把词条并进 t() 用的总表
addEnglish({ ...settingsEn, ...conversationEn, ...pluginsEn, ...cardsEn });
