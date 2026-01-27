export interface INavItem {
  id: string;
  label: string;
  icon: string;
  badge?: number;
}

export interface INavGroup {
  label: string;
  items: INavItem[];
}

export interface IStatCard {
  label: string;
  value: string;
  change?: string;
  changeType?: 'positive' | 'negative';
  iconType: 'blue' | 'green' | 'orange';
}

export interface IActivityItem {
  id: string;
  name: string;
  role: string;
  location: string;
  status: 'in' | 'out' | 'late';
  time: string;
  initials: string;
}

export interface IProgressItem {
  id: string;
  label: string;
  current: number;
  total: number;
}

export interface IQuickAction {
  id: string;
  label: string;
  icon: string;
}
