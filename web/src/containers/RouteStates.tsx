import { Link } from 'react-router';
import { EmptyState, StudioShell } from '../components/StudioPrimitives';

function routeFallback(title: string, message: string) {
  return (
    <StudioShell>
      <EmptyState
        title={title}
        action={
          <Link className="button button--secondary" to="/">
            Back to source videos
          </Link>
        }
      >
        {message}
      </EmptyState>
    </StudioShell>
  );
}

export function NotFoundState({ message }: { message: string }) {
  return routeFallback('Nothing here', message);
}

export function LoadErrorState({ message }: { message: string }) {
  return routeFallback('This page could not be loaded', message);
}
