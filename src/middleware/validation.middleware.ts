import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';

export const validateRequest = (schema: Joi.ObjectSchema, source: 'body' | 'query' | 'params' = 'body') => {
  return (req: Request, res: Response, next: NextFunction) => {
    const dataToValidate = source === 'body' ? req.body :
                          source === 'query' ? req.query :
                          req.params;

    const { error, value } = schema.validate(dataToValidate, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const details = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        type: detail.type
      }));

      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details
      });
    }

    // Replace the original data with validated data
    if (source === 'body') req.body = value;
    else if (source === 'query') {
      // For query validation, we just validate but don't replace
      // The original req.query is immutable in Express
    } else {
      req.params = value;
    }

    next();
  };
};