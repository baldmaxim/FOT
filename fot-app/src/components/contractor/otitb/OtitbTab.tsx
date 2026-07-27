import { Fragment, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../../contexts/AuthContext';
import { contractorAdminService, type IInductionOrg } from '../../../services/contractorService';
import { useOtCatalog } from './otitbShared';
import { OtitbOrgDetail } from './OtitbOrgDetail';
import { OtitbFlatList } from './OtitbFlatList';
import contractorStyles from '../../../pages/contractor/Contractor.module.css';
import styles from './Otitb.module.css';

/**
 * Вкладка «ОТиТБ»: реестр обучения по охране труда сотрудников подрядчиков.
 * По умолчанию — список организаций со счётчиком замечаний (раскрывается в реестр),
 * чекбокс «Показать всех» переключает на плоский список по всем организациям.
 * Даты вносятся в модалке; прошедший вводный инструктаж далее доступен подрядчику
 * в выпадающем списке ФИО при заполнении пропуска.
 */
export const OtitbTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const canEdit = isAdmin
    || canEditPage('/admin/contractor-approvals')
    || canEditPage('/admin/contractor-approvals/otitb');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flat, setFlat] = useState(false);
  const catalog = useOtCatalog();

  const orgsQuery = useQuery({
    queryKey: ['contractor-induction-orgs'],
    queryFn: () => contractorAdminService.getInductionOrgs(),
    staleTime: 30_000,
    enabled: !flat,
  });
  const orgs: IInductionOrg[] = orgsQuery.data ?? [];

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={flat} onChange={e => setFlat(e.target.checked)} />
        Показать всех
      </label>

      {flat ? (
        <OtitbFlatList canEdit={canEdit} catalog={catalog} />
      ) : orgsQuery.isLoading ? (
        <div className={contractorStyles.empty}>Загрузка…</div>
      ) : orgs.length === 0 ? (
        <div className={contractorStyles.empty}>Подрядные организации не найдены</div>
      ) : (
        <table className={contractorStyles.table}>
          <thead>
            <tr>
              <th>Организация</th>
              <th style={{ width: 120 }}>Всего</th>
              <th style={{ width: 180 }}>Есть замечания</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map(org => {
              const isOpen = expanded === org.id;
              return (
                <Fragment key={org.id}>
                  <tr className={org.alert_count > 0 ? styles.rowAlert : undefined}>
                    <td
                      onClick={() => setExpanded(isOpen ? null : org.id)}
                      style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 600 }}
                      title={isOpen ? 'Скрыть список' : 'Показать список'}
                    >
                      <span style={{ display: 'inline-block', width: 14, color: 'var(--text-secondary)' }}>
                        {isOpen ? '▾' : '▸'}
                      </span>
                      {org.name}
                    </td>
                    <td>{org.inducted_count}</td>
                    <td className={org.alert_count > 0 ? styles.orgAlert : undefined}>
                      {org.alert_count}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={3}>
                        <OtitbOrgDetail orgId={org.id} canEdit={canEdit} catalog={catalog} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default OtitbTab;
