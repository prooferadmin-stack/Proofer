export type SessionType = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  duration_minutes: number;
  price_cents: number;
  deposit_cents: number | null;
  currency: string;
  is_public: boolean;
  active: boolean;
  contract_template_id: string | null;
  questionnaire_template_id: string | null;
  min_notice_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  max_bookings_per_day: number | null;
  // Sold as a gift card worth this session (2.7, migration 0032).
  gift_card_offered?: boolean;
  created_at: string;
  updated_at: string;
};

export type TemplateOption = { id: string; name: string };
