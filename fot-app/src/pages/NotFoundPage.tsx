import type { FC } from 'react';
import { Link } from 'react-router-dom';

interface INotFoundPageProps {
  title?: string;
  message?: string;
}

export const NotFoundPage: FC<INotFoundPageProps> = ({
  title = 'Страница не найдена',
  message = 'Похоже, этот маршрут больше не существует или был удалён во время чистки проекта.',
}) => {
  return (
    <div style={{ padding: '40px 24px', maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 12 }}>{title}</h1>
      <p style={{ marginBottom: 20, lineHeight: 1.5 }}>{message}</p>
      <Link to="/" style={{ color: 'inherit', textDecoration: 'underline' }}>
        Вернуться на главную
      </Link>
    </div>
  );
};
