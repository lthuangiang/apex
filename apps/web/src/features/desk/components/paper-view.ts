"use client";

import { paperViewSchema } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** Số liệu bài thử tiền giả (trang Fake-money test và Test results dùng chung một key). */
export function usePaperView(id: string) {
  return useQuery({
    queryKey: ["desk", "paper", id],
    queryFn: () => api("GET", `/api/v1/desk/paper/${id}`, paperViewSchema),
    refetchInterval: 15_000,
  });
}
