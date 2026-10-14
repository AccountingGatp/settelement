import "./globals.css";
export const metadata = { title: "Settlement Reconciliation", description: "Check settled sales and refunds against WooCommerce and correct QuickBooks Online" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
