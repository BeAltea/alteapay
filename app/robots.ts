import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://alteapay.com"

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/auth/",
          "/dashboard/",
          "/super-admin/",
          "/user-dashboard/",
          "/api/",
          "/c/",
          "/portal/",
          "/localize/",
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  }
}
