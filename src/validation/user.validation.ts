import Joi from 'joi';

// User profile update validation
export const updateProfileSchema = Joi.object({
  firstName: Joi.string()
    .min(2)
    .max(50)
    .pattern(/^[a-zA-Z\s]+$/)
    .optional()
    .messages({
      'string.min': 'First name must be at least 2 characters long',
      'string.max': 'First name cannot exceed 50 characters',
      'string.pattern.base': 'First name can only contain letters and spaces'
    }),

  lastName: Joi.string()
    .min(2)
    .max(50)
    .pattern(/^[a-zA-Z\s]+$/)
    .optional()
    .messages({
      'string.min': 'Last name must be at least 2 characters long',
      'string.max': 'Last name cannot exceed 50 characters',
      'string.pattern.base': 'Last name can only contain letters and spaces'
    }),

  phone: Joi.string()
    .pattern(/^\+?[1-9]\d{1,14}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Phone number must be in valid international format'
    }),

  bio: Joi.string()
    .max(500)
    .optional()
    .allow('')
    .messages({
      'string.max': 'Bio cannot exceed 500 characters'
    }),

  timezone: Joi.string()
    .pattern(/^[A-Za-z_\/]+$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid timezone format'
    }),

  preferredLanguage: Joi.string()
    .length(2)
    .pattern(/^[a-z]{2}$/)
    .optional()
    .messages({
      'string.length': 'Language code must be exactly 2 characters',
      'string.pattern.base': 'Language code must be in ISO 639-1 format (e.g., en, es, fr)'
    })
});

// User preferences validation
export const updatePreferencesSchema = Joi.object({
  emailNotifications: Joi.boolean().optional(),
  smsNotifications: Joi.boolean().optional(),
  pushNotifications: Joi.boolean().optional(),
  marketingEmails: Joi.boolean().optional(),
  appointmentReminders: Joi.boolean().optional(),
  messageNotifications: Joi.boolean().optional()
});

// Privacy settings validation
export const updatePrivacySchema = Joi.object({
  profileVisibility: Joi.string()
    .valid('public', 'private', 'lawyers_only')
    .optional()
    .messages({
      'any.only': 'Profile visibility must be one of: public, private, lawyers_only'
    }),

  showEmail: Joi.boolean().optional(),
  showPhone: Joi.boolean().optional(),
  allowSearchEngineIndexing: Joi.boolean().optional(),
  showInDirectory: Joi.boolean().optional(),
  allowDirectMessages: Joi.boolean().optional()
});

// Image upload validation
export const imageUploadSchema = Joi.object({
  mimetype: Joi.string()
    .valid('image/jpeg', 'image/png', 'image/webp')
    .required()
    .messages({
      'any.only': 'Only JPEG, PNG, and WebP images are allowed'
    }),

  size: Joi.number()
    .max(5 * 1024 * 1024) // 5MB
    .required()
    .messages({
      'number.max': 'Image size cannot exceed 5MB'
    })
});

// Common field validations
export const commonValidations = {
  userId: Joi.string().required(),
  email: Joi.string().email().required(),
  clerkUserId: Joi.string().required()
};

// Profile completion calculation fields
export const profileFields = {
  required: ['firstName', 'lastName', 'email'], // 20 points each
  optional: ['phone', 'bio', 'profileImageUrl'], // 10 points each
  lawyerRequired: ['licenseNumber', 'practiceAreas', 'experience', 'hourlyRate'] // 10 points each for lawyers
};