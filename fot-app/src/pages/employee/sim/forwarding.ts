import type { ForwardingType, IForwardingRule } from '../../../services/mySimService';

// Общее для карточки SIM (ярлык «Переадресация включена») и модалки управления.

export const FORWARDING_TYPES: ForwardingType[] = ['CFU', 'CFNRY', 'CFNRC'];

export const FORWARDING_TYPE_LABELS: Record<ForwardingType, string> = {
  CFU: 'Переадресовывать всегда',
  CFNRY: 'Если не отвечаю',
  CFNRC: 'Если недоступен',
};

/** Короткая подпись для ярлыка в карточке. */
export const FORWARDING_TYPE_SHORT: Record<ForwardingType, string> = {
  CFU: 'всегда',
  CFNRY: 'если не отвечаю',
  CFNRC: 'если недоступен',
};

export const DEFAULT_NO_REPLY_TIMER = 20;

export const isForwardingType = (t: string | null | undefined): t is ForwardingType =>
  FORWARDING_TYPES.includes(t as ForwardingType);

/** Активное правило = первое с поддерживаемым типом и указанным номером назначения. */
export const pickForwardingRule = (rules: IForwardingRule[]): IForwardingRule | null =>
  rules.find(r => isForwardingType(r.forwardingType) && Boolean(r.forwardingAddress)) ?? null;
