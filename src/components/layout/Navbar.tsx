'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, LogOut, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

type Me = { user: { user_id: number; user_name: string; official_email: string }; role?: { role_name: string } };

export function Navbar({ onToggleSidebar }: { onToggleSidebar?: () => void }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [unread, setUnread] = useState<number>(0);

  useEffect(() => {
    api.get<Me>('/auth/me').then(setMe).catch(() => router.push('/login'));
    api.get<{ unread: number }>('/admin/notifications/inbox/count').then((d) => setUnread(d.unread)).catch(() => {});
  }, [router]);

  async function logout() {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    localStorage.removeItem('crm_auth_token');
    router.push('/login');
  }

  return (
    <header className="h-14 border-b bg-card px-4 flex items-center gap-3">
      <Button variant="ghost" size="icon" onClick={onToggleSidebar} className="md:hidden">
        <Menu className="h-5 w-5" />
      </Button>
      <div className="flex-1" />
      <button
        onClick={() => router.push('/notifications')}
        className="relative rounded p-2 hover:bg-muted"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-destructive text-[10px] text-destructive-foreground grid place-items-center font-semibold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      <div className="flex items-center gap-3 border-l pl-3">
        <div className="hidden sm:block text-right text-xs">
          <div className="font-medium">{me?.user?.user_name ?? '…'}</div>
          <div className="text-muted-foreground">{me?.role?.role_name ?? me?.user?.official_email ?? ''}</div>
        </div>
        <Button variant="ghost" size="icon" onClick={logout} title="Log out">
          <LogOut className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}
