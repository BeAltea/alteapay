"use client"

import { useState } from "react"
import { AdminSidebar } from "./admin-sidebar"
import { AdminHeader } from "./admin-header"

interface AdminSidebarWrapperProps {
  user: {
    id: string
    email?: string
    profile?: {
      role: string
      company_id: string | null
      full_name: string | null
      company: {
        id: string
        name: string
      } | null
    }
  }
  children: React.ReactNode
}

export function AdminSidebarWrapper({ user, children }: AdminSidebarWrapperProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  return (
    <>
      {/* Sidebar */}
      <AdminSidebar
        user={user}
        isMobileMenuOpen={isMobileMenuOpen}
        setIsMobileMenuOpen={setIsMobileMenuOpen}
      />

      {/* Main Content Area */}
      <div
        className="flex-1 flex flex-col min-w-0 overflow-hidden lg:ml-[250px]"
      >
        <AdminHeader
          user={user}
          onMenuClick={() => setIsMobileMenuOpen(true)}
        />
        <main
          className="flex-1 min-h-0 overflow-y-auto"
          style={{ background: "var(--admin-bg-primary)" }}
        >
          <div className="p-7">
            {children}
          </div>
        </main>
      </div>
    </>
  )
}
