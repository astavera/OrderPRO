import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ service: "orderpro", status: "ok", productionOperationsEnabled: false });
}
