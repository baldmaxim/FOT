import { type FC } from 'react';
import {
  fmtPackage, fmtPackageValue, packageHasData, packageLabel, packagePercent, PACKAGE_COLORS,
} from './mtsBusinessFormat';
import styles from './PackageMeters.module.css';

interface IPackage {
  name?: string | null;
  unitOfMeasure: string | null;
  quota: number | null;
  remainder: number | null;
}

/** Порядок строк: минуты → SMS → интернет → прочее. */
const UNIT_ORDER: Record<string, number> = { SECOND: 0, MINUTE: 0, ITEM: 1, BYTE: 2 };
const unitOrder = (p: IPackage): number => UNIT_ORDER[p.unitOfMeasure ?? ''] ?? 3;

/**
 * Остатки пакетов номера (минуты/SMS/интернет). Полоса — «наоборот»: полная
 * при нетронутом пакете и уменьшается к нулю по мере расходования; при
 * остатке ≤15% — красная. Квоты в ValidityInfo нет — без неё показываем
 * «осталось X» без «из Y» и без полосы. Дедупликация по имени счётчика +
 * строке значения (МТС иногда шлёт дубли). Пустой набор данных → null
 * (секцию не показываем). Переиспользуется в админ-дровере «Абоненты»
 * и в ЛК «Моя SIM».
 */
export const PackageMeters: FC<{ packages: IPackage[] }> = ({ packages }) => {
  // Нулевой остаток без квоты не показываем: это почти всегда служебные
  // счётчики МТС (корп. бюджет, вечный роуминг-GPRS), а не исчерпанный пакет.
  const rows = packages.filter(p => packageHasData(p) && !(p.remainder === 0 && p.quota == null));
  const seen = new Set<string>();
  const unique = rows.filter(p => {
    const key = `${p.name ?? ''}|${fmtPackage(p)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return null;
  const ordered = [...unique].sort((a, b) => unitOrder(a) - unitOrder(b));

  return (
    <div className={styles.list}>
      {ordered.map((p, i) => {
        const pct = packagePercent(p);
        const low = pct != null && pct <= 0.15;
        const color = low
          ? '#ef4444'
          : (p.unitOfMeasure && PACKAGE_COLORS[p.unitOfMeasure]) || 'var(--primary)';
        return (
          <div key={`pkg-${i}`} className={styles.item}>
            <div className={styles.head}>
              <span className={styles.label}>
                {packageLabel(p)}
                {p.name && <span className={styles.name}> · {p.name}</span>}
              </span>
              <span className={styles.value}>
                {p.quota != null && <span className={styles.of}>осталось </span>}
                <b>{fmtPackageValue(p, p.remainder)}</b>
                {p.quota != null && <span className={styles.of}> из {fmtPackageValue(p, p.quota)}</span>}
              </span>
            </div>
            {pct != null && (
              <div className={styles.track}>
                <div
                  className={styles.fill}
                  style={{ width: `${Math.round(pct * 100)}%`, background: color }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
