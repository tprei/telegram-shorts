import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { InboxPage } from './containers/InboxPage';
import { JobPage } from './containers/JobPage';
import { ShortEditorPage } from './containers/ShortEditorPage';

const queryClient = new QueryClient();

const router = createBrowserRouter([
  { path: '/', element: <InboxPage /> },
  { path: '/jobs/:jobId', element: <JobPage /> },
  { path: '/shorts/:shortId', element: <ShortEditorPage /> },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
