// Error yang AMAN ditampilkan ke client: status HTTP + kode + pesan (tanpa detail SQL/stack).
export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields; // { namaField: "pesan" } untuk error validasi
  }
}

export const badRequest = (message, fields) => new ApiError(400, "VALIDATION_ERROR", message, fields);
export const forbidden = (message = "Anda tidak memiliki akses untuk aksi ini.") => new ApiError(403, "FORBIDDEN", message);
export const notFound = (message = "Data tidak ditemukan.") => new ApiError(404, "NOT_FOUND", message);
export const conflict = (message) => new ApiError(409, "CONFLICT", message);
// Teks berisi lone surrogate / karakter format (Cf) / kontrol (Cc) yang tidak diizinkan (lib/text.js).
export const invalidText = (field, message) => new ApiError(400, "INVALID_TEXT", "Teks berisi karakter yang tidak diizinkan.", { [field]: message });
