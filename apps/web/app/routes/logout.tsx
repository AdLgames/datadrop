import { redirect } from 'react-router';
import type { Route } from './+types/logout';
import { getApp } from '../services/app.server';
import { assertSameOrigin } from '../services/auth.server';
import { userClient } from '../services/supabase.server';

export const action = async ({ request }: Route.ActionArgs) => {
  const app = getApp();
  assertSameOrigin(request, app.appUrl);
  const { supabase, headers } = userClient(app.env, request);
  await supabase.auth.signOut();
  throw redirect('/login', { headers });
};

export const loader = () => redirect('/login');
