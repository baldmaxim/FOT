import { type FC } from 'react';
import {
  fmtPackage, fmtPackageValue, packageHasData, packageLabel, packagePercent, PACKAGE_COLORS,
} from './mtsBusinessFormat';
import styles from './PackageMeters.module.css';

interface IPackage {
  unitOfMeasure: string | null;
  quota: number | null;
  remainder: number | null;
}

/**
 * Остатки пакетов номера (минуты/SMS/интернет) с полосой заполнения.
 * Дедупликация по строке `fmtPackage` (МТС иногда шлёт дубли счётчиков).
 * Пустой набор данных → null (секцию не показываем). Переиспользуется в
 * админ-дровере «Абоненты» и в ЛК «Моя SIM».
 */
export const PackageMeters: FC<{ packages: IPackage[] }> = ({ packages }) => {
  const rows = packages.filter(packageHasData);
  const seen = new Set<string>();
  const unique = rows.filter(p => {
    const key = fmtPackage(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return null;

  return (
    <div className={styles.list}>
      {unique.map((p, i) => {
        const pct = packagePercent(p);
        const color = (p.unitOfMeasure && PACKAGE_COLORS[p.unitOfMeasure]) || 'var(--primary)';
        return (
          <div key={`pkg-${i}`} className={styles.item}>
            <div className={styles.head}>
              <span className={styles.label}>{packageLabel(p)}</span>
              <span className={styles.value}>
                <b>{fmtPackageValue(p, p.remainder)}</b>
                <span className={styles.of}> из {fmtPackageValue(p, p.quota)}</span>
              </span>
            </div>
            <div className={styles.track}>
              <div
                className={styles.fill}
                style={{ width: pct != null ? `${Math.round(pct * 100)}%` : '0%', background: color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
