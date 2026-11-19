import { PaginationParams, PaginatedResponse } from '../types';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Parse page & pageSize from query params with safe defaults */
export function parsePagination(query: Record<string, any>): PaginationParams {
  let page = parseInt(query.page, 10);
  if (isNaN(page) || page < 1) page = DEFAULT_PAGE;

  let pageSize = parseInt(query.pageSize, 10);
  if (isNaN(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  return { page, pageSize };
}

/** Build a paginated response object with both top-level and nested pagination */
export function buildPaginatedResponse<T>(
  data: T[],
  totalItems: number,
  params: PaginationParams
): any {
  const totalPages = Math.ceil(totalItems / params.pageSize) || 1;
  return {
    data,
    total: totalItems,
    page: params.page,
    limit: params.pageSize,
    totalPages,
    pagination: {
      page: params.page,
      pageSize: params.pageSize,
      totalItems,
      totalPages,
    },
  };
}
